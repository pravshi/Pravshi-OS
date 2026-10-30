import { describe, expect, it } from 'vitest';

import { isFromMergedPr } from '../../scripts/ci/verify-pr-merge.mjs';

const SHA = 'a'.repeat(40);

describe('direct-push audit uses PR association, not commit subject (finding #3)', () => {
  it('accepts the merge commit of a genuinely merged PR', () => {
    const r = isFromMergedPr(SHA, [
      {
        number: 7,
        merged_at: '2026-09-07T00:00:00Z',
        merge_commit_sha: SHA,
        base: { ref: 'main' },
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it('accepts a squash or rebase tip that is the merge result of a PR into main', () => {
    // GitHub reports the squash commit / rebased tip as merge_commit_sha; it equals the pushed sha.
    const r = isFromMergedPr(SHA, [
      {
        number: 8,
        merged_at: '2026-09-07T00:00:00Z',
        merge_commit_sha: SHA,
        base: { ref: 'main' },
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it('rejects a commit that is merely associated with a merged PR (different merge result)', () => {
    const r = isFromMergedPr(SHA, [
      {
        number: 8,
        merged_at: '2026-09-07T00:00:00Z',
        merge_commit_sha: 'b'.repeat(40),
        base: { ref: 'main' },
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a PR merged into a different base branch, even with the same merge sha', () => {
    const r = isFromMergedPr(SHA, [
      { number: 9, merged_at: '2026-09-07T00:00:00Z', merge_commit_sha: SHA, base: { ref: 'tmp' } },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a merged PR whose base is missing from the payload', () => {
    const r = isFromMergedPr(SHA, [
      { number: 9, merged_at: '2026-09-07T00:00:00Z', merge_commit_sha: SHA },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects an ordinary direct push (no associated PR)', () => {
    const r = isFromMergedPr(SHA, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no pull request/i);
  });

  it('rejects a forged "(#123)" subject, because the subject is never consulted', () => {
    // The API is the only input. A crafted commit message associates with nothing.
    const r = isFromMergedPr(SHA, []);
    expect(r.ok).toBe(false);
  });

  it('rejects an associated but UNMERGED pull request', () => {
    const r = isFromMergedPr(SHA, [{ number: 9, merged_at: null, merge_commit_sha: null }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/none is merged/i);
  });
});
