import { describe, expect, it } from 'vitest';

import { ALLOWED_PARENT, assertParentAllowed } from '../../scripts/ci/provision-branch-role.mjs';

describe('ephemeral CI parent allowlist', () => {
  it('permits only production (single-branch model, 2026-10-06)', () => {
    expect(ALLOWED_PARENT).toBe('production');
    expect(assertParentAllowed('production')).toBe('production');
    expect(assertParentAllowed('  production  ')).toBe('production');
  });

  it('fails closed for staging, main, unknown and empty', () => {
    for (const bad of ['staging', 'main', 'develop', 'ci/whatever', '', '   ']) {
      expect(() => assertParentAllowed(bad)).toThrow(/must be exactly "production"/);
    }
    expect(() => assertParentAllowed(undefined)).toThrow(/must be exactly "production"/);
    expect(() => assertParentAllowed(null)).toThrow(/must be exactly "production"/);
  });
});
