import { describe, expect, it } from 'vitest';

import { ALLOWED_PARENT, assertParentAllowed } from '../../scripts/ci/provision-branch-role.mjs';

describe('ephemeral CI parent allowlist (finding #4)', () => {
  it('permits only staging', () => {
    expect(ALLOWED_PARENT).toBe('staging');
    expect(assertParentAllowed('staging')).toBe('staging');
    expect(assertParentAllowed('  staging  ')).toBe('staging');
  });

  it('rejects production even if production were no longer the default branch', () => {
    // The old check keyed on `default`, so a non-default production would have passed.
    expect(() => assertParentAllowed('production')).toThrow(/must be exactly "staging"/);
  });

  it('fails closed for main, unknown and empty', () => {
    for (const bad of ['main', 'develop', 'ci/whatever', '', '   ']) {
      expect(() => assertParentAllowed(bad)).toThrow(/must be exactly "staging"/);
    }
    expect(() => assertParentAllowed(undefined)).toThrow(/must be exactly "staging"/);
    expect(() => assertParentAllowed(null)).toThrow(/must be exactly "staging"/);
  });
});
