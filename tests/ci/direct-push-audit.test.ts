import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPARE_COMMIT_CAP,
  PROTECTED_PATHS,
  auditCommit,
  evaluateCiRuns,
  evaluatePushRange,
  hasSkipCiMarker,
  isProtectedPath,
} from '../../scripts/ci/verify-pr-merge.mjs';

const SHA = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);

const commit = (message = 'Milestone: docs') => ({ commit: { message } });
const rangeOf = (over: Record<string, unknown> = {}) => ({
  status: 'ahead',
  total_commits: 1,
  commits: [commit()],
  files: [{ filename: 'docs/x.md' }],
  ...over,
});

describe('direct milestone push: the static range verdict', () => {
  it('accepts a plain fast-forward that touches no protected file', () => {
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf() }).ok).toBe(true);
  });

  it('rejects a force push', () => {
    const r = evaluatePushRange({ forced: true, before: BEFORE, compare: rangeOf() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/force push/);
  });

  it.each(['diverged', 'behind', 'identical'])('rejects compare status "%s"', (status) => {
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf({ status }) }).ok).toBe(false);
  });

  it('rejects a missing or all-zero previous tip', () => {
    expect(evaluatePushRange({ before: undefined, compare: rangeOf() }).ok).toBe(false);
    expect(evaluatePushRange({ before: '0'.repeat(40), compare: rangeOf() }).ok).toBe(false);
  });

  it('fails closed when the range is truncated, empty or capped', () => {
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf({ total_commits: 9 }) }).ok).toBe(
      false,
    );
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf({ commits: [] }) }).ok).toBe(false);
    const many = Array.from({ length: COMPARE_COMMIT_CAP }, () => commit());
    expect(
      evaluatePushRange({
        before: BEFORE,
        compare: rangeOf({ commits: many, total_commits: many.length }),
      }).ok,
    ).toBe(false);
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` }));
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf({ files }) }).ok).toBe(false);
  });

  it.each(['[skip ci]', '[CI SKIP]', '[no ci]', '[skip actions]', 'skip-checks: true'])(
    'rejects a commit carrying the skip marker %s',
    (marker) => {
      const r = evaluatePushRange({
        before: BEFORE,
        compare: rangeOf({ commits: [commit(`docs ${marker}`)] }),
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/skip/);
    },
  );

  it.each([
    '.github/workflows/ci.yml',
    'scripts/ci/verify-pr-merge.mjs',
    'scripts/guards/secret-scan.mjs',
    'scripts/db/roles.sql',
    'drizzle/0089_x.sql',
    'scripts/migrate-ws.mjs',
  ])('rejects a range that changes the protected file %s', (filename) => {
    const r = evaluatePushRange({ before: BEFORE, compare: rangeOf({ files: [{ filename }] }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protected/);
  });

  it('also sees a protected file that was renamed away', () => {
    const r = evaluatePushRange({
      before: BEFORE,
      compare: rangeOf({
        files: [{ filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' }],
      }),
    });
    expect(r.ok).toBe(false);
  });

  it('matches protected paths by prefix, not by substring', () => {
    expect(isProtectedPath('docs/.github/notes.md')).toBe(false);
    expect(isProtectedPath('scriptsx/migrate-ws.mjs')).toBe(false);
    expect(isProtectedPath('.\\.github\\workflows\\ci.yml')).toBe(true);
    expect(PROTECTED_PATHS).toContain('.github/');
  });

  it('detects skip markers case-insensitively and ignores ordinary text', () => {
    expect(hasSkipCiMarker('Fix [Skip CI] now')).toBe(true);
    expect(hasSkipCiMarker('we skip ci discussions here')).toBe(false);
    expect(hasSkipCiMarker(undefined)).toBe(false);
  });
});

describe('direct milestone push: the ci verdict', () => {
  it('passes only on a completed, successful run', () => {
    expect(evaluateCiRuns([{ status: 'completed', conclusion: 'success' }]).state).toBe('pass');
  });

  it.each(['failure', 'timed_out', 'action_required', 'skipped', 'neutral'])(
    'fails on a completed run with conclusion %s',
    (conclusion) => {
      expect(evaluateCiRuns([{ status: 'completed', conclusion }]).state).toBe('fail');
    },
  );

  it('waits while a run is queued or in progress, and while none exists', () => {
    expect(evaluateCiRuns([{ status: 'in_progress', conclusion: null }]).state).toBe('wait');
    expect(evaluateCiRuns([{ status: 'queued', conclusion: null }]).state).toBe('wait');
    expect(evaluateCiRuns([]).state).toBe('wait');
  });

  it('treats a cancelled run as covered only by a later successful descendant run', () => {
    const cancelled = [{ status: 'completed', conclusion: 'cancelled' }];
    expect(evaluateCiRuns(cancelled, false).state).toBe('wait');
    expect(evaluateCiRuns(cancelled, true).state).toBe('pass');
  });

  it('a green rerun of the same commit passes but names the earlier failed run; failures alone never pass', () => {
    const green = evaluateCiRuns([
      { status: 'completed', conclusion: 'failure' },
      { status: 'completed', conclusion: 'success' },
    ]);
    expect(green.state).toBe('pass');
    expect(green.reason).toMatch(/earlier failed run/);
    expect(
      evaluateCiRuns([
        { status: 'completed', conclusion: 'failure' },
        { status: 'completed', conclusion: 'success' },
      ]).state,
    ).toBe('pass');
    expect(
      evaluateCiRuns([
        { status: 'completed', conclusion: 'failure' },
        { status: 'completed', conclusion: 'cancelled' },
      ]).state,
    ).toBe('fail');
  });
});

type Reply = unknown | ((path: string) => unknown);

/** A fake GitHub API: the first matching route wins; an unknown route fails the test. */
function fakeApi(routes: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    for (const [re, reply] of routes)
      if (re.test(path)) return typeof reply === 'function' ? reply(path) : reply;
    throw new Error(`unexpected API call ${path}`);
  };
  return { api, calls };
}

const run = (over: Record<string, unknown> = {}) => ({
  head_sha: SHA,
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  ...over,
});

const base = { sha: SHA, before: BEFORE, forced: false, waitMs: 60_000 };

describe('direct-push audit end to end (fake GitHub)', () => {
  it('passes a merged PR without consulting CI or the range', async () => {
    const { api, calls } = fakeApi([
      [
        /\/pulls$/,
        [
          {
            number: 1,
            merged_at: '2026-10-30T00:00:00Z',
            merge_commit_sha: SHA,
            base: { ref: 'main' },
          },
        ],
      ],
    ]);
    const v = await auditCommit({ ...base, api, sleep: async () => {} });
    expect(v.ok).toBe(true);
    expect(v.path).toBe('pr');
    expect(calls).toHaveLength(1);
  });

  it('passes a fast-forward milestone whose own ci run succeeded', async () => {
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run()] }],
    ]);
    const v = await auditCommit({ ...base, api, sleep: async () => {} });
    expect(v).toMatchObject({ ok: true, path: 'direct' });
  });

  it('fails a direct push whose ci run failed', async () => {
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run({ conclusion: 'failure' })] }],
    ]);
    expect((await auditCommit({ ...base, api, sleep: async () => {} })).ok).toBe(false);
  });

  it('ignores a green ci run that belongs to a different commit', async () => {
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run({ head_sha: 'c'.repeat(40) })] }],
    ]);
    let t = 0;
    const v = await auditCommit({
      ...base,
      api,
      waitMs: 90_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/gave up waiting/);
  });

  it('waits for an in-progress run and then passes', async () => {
    let polls = 0;
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [
        /workflows\/ci\.yml\/runs/,
        () => ({
          workflow_runs: [polls++ < 2 ? run({ status: 'in_progress', conclusion: null }) : run()],
        }),
      ],
    ]);
    let t = 0;
    const v = await auditCommit({
      ...base,
      api,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    expect(v.ok).toBe(true);
    expect(polls).toBe(3);
  });

  it('fails a forced push before consulting CI, even when compare looks like a fast-forward', async () => {
    const { api, calls } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
    ]);
    const v = await auditCommit({ ...base, forced: true, api, sleep: async () => {} });
    expect(v.ok).toBe(false);
    expect(calls.some((c) => c.includes('workflows'))).toBe(false);
  });

  it('fails a protected-file change even when ci is green', async () => {
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf({ files: [{ filename: '.github/workflows/ci.yml' }] })],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run()] }],
    ]);
    const v = await auditCommit({ ...base, api, sleep: async () => {} });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/protected/);
  });

  it('accepts a cancelled run only when a later successful run descends from the commit', async () => {
    const LATER = 'd'.repeat(40);
    const mk = (cmpStatus: string) =>
      fakeApi([
        [/\/pulls$/, []],
        [new RegExp(`^/compare/${BEFORE}`), rangeOf()],
        [new RegExp(`^/compare/${SHA}\\.\\.\\.${LATER}`), { status: cmpStatus }],
        [/status=success/, { workflow_runs: [run({ head_sha: LATER })] }],
        [/head_sha=/, { workflow_runs: [run({ conclusion: 'cancelled' })] }],
      ]);
    const ok = await auditCommit({ ...base, api: mk('ahead').api, sleep: async () => {} });
    expect(ok.ok).toBe(true);

    let t = 0;
    const bad = await auditCommit({
      ...base,
      api: mk('diverged').api,
      waitMs: 30_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('hardening found in review', () => {
  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.nvmrc',
    'vitest.config.mts',
    'tests/guards/new.test.ts',
    'tests/ci/direct-push-audit.test.ts',
    'scripts/ops/anything.mjs',
    'patches/x.patch',
    'apps/web/src/middleware.ts',
    'tsconfig.base.json',
    'apps/web/package.json',
    'apps/web/next.config.ts',
    'apps/web/vercel.json',
    'src/env.ts',
    'AGENTS.md',
    '.claude/rules/git-and-release.md',
  ])(
    'rejects a direct push that changes %s (decides what CI proves or the founder decides)',
    (filename) => {
      const r = evaluatePushRange({ before: BEFORE, compare: rangeOf({ files: [{ filename }] }) });
      expect(r.ok).toBe(false);
    },
  );

  it('sees a protected file renamed away and matches case-insensitively', () => {
    expect(
      evaluatePushRange({
        before: BEFORE,
        compare: rangeOf({
          files: [{ filename: 'docs/a.ts', previous_filename: 'tests/guards/a.ts' }],
        }),
      }).ok,
    ).toBe(false);
    expect(isProtectedPath('Package.JSON')).toBe(true);
    expect(isProtectedPath('.GitHub/Workflows/ci.yml')).toBe(true);
  });

  it('still accepts ordinary application and documentation changes', () => {
    const files = [
      { filename: 'src/lib/crm/companies.ts' },
      { filename: 'tests/db/crm.test.ts' },
      { filename: 'docs/architecture/x.md' },
    ];
    expect(evaluatePushRange({ before: BEFORE, compare: rangeOf({ files }) }).ok).toBe(true);
  });

  it('refuses a malformed commit or previous-tip sha before using it in an API path', async () => {
    const { api } = fakeApi([]);
    await expect(
      auditCommit({ ...base, sha: 'not-a-sha/../x', api, sleep: async () => {} }),
    ).rejects.toThrow(/COMMIT_SHA/);
    await expect(
      auditCommit({ ...base, before: '../evil', api, sleep: async () => {} }),
    ).rejects.toThrow(/BEFORE_SHA/);
  });

  it('asks GitHub for exactly this commit on main, push event, and the full compare page', async () => {
    const { api, calls } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run()] }],
    ]);
    await auditCommit({ ...base, api, sleep: async () => {} });
    expect(calls).toContain(`/compare/${BEFORE}...${SHA}?per_page=${COMPARE_COMMIT_CAP}`);
    const runsCall = calls.find((c) => c.includes('workflows/ci.yml/runs')) ?? '';
    expect(runsCall).toContain(`head_sha=${SHA}`);
    expect(runsCall).toContain('event=push');
    expect(runsCall).toContain('branch=main');
  });

  it('ignores a green ci run for this sha that did not run on main', async () => {
    const { api } = fakeApi([
      [/\/pulls$/, []],
      [/^\/compare\//, rangeOf()],
      [/workflows\/ci\.yml\/runs/, { workflow_runs: [run({ head_branch: 'develop' })] }],
    ]);
    let t = 0;
    const v = await auditCommit({
      ...base,
      api,
      waitMs: 30_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    expect(v.ok).toBe(false);
  });

  it('a PR merged into another base does not vouch for a direct push', async () => {
    const { api } = fakeApi([
      [
        /\/pulls$/,
        [
          {
            number: 5,
            merged_at: '2026-10-30T00:00:00Z',
            merge_commit_sha: SHA,
            base: { ref: 'tmp' },
          },
        ],
      ],
      [/^\/compare\//, rangeOf({ files: [{ filename: '.github/workflows/ci.yml' }] })],
    ]);
    const v = await auditCommit({ ...base, api, sleep: async () => {} });
    expect(v.ok).toBe(false);
    expect(v.path).toBe('direct');
  });
});

describe('workflow wiring', () => {
  const yml = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'direct-push-audit.yml'),
    'utf8',
  );

  it('passes the previous tip and the forced flag from the push event, via env not run', () => {
    expect(yml).toMatch(/BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
    expect(yml).toMatch(/FORCED: \$\{\{ github\.event\.forced \}\}/);
    expect(yml).toMatch(/COMMIT_SHA: \$\{\{ github\.sha \}\}/);
    expect(yml).not.toMatch(/run: .*\$\{\{/);
  });

  it('stays read-only and runs only on pushes to main', () => {
    expect(yml).toMatch(
      /permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}actions: read\n/,
    );
    expect(yml).not.toMatch(/: write/);
    expect(yml).toMatch(/push:\n {4}branches: \[main\]/);
  });
});
