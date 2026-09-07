import { describe, expect, it } from 'vitest';
import { isRetryableConnectError } from '@/lib/db/pool';

describe('isRetryableConnectError', () => {
  it('retries the errors a Neon cold start produces', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '08006', '08001']) {
      expect(isRetryableConnectError({ code })).toBe(true);
    }
  });

  it('does not retry a constraint violation', () => {
    expect(isRetryableConnectError({ code: '23505' })).toBe(false);
  });

  it('does not retry an unknown shape', () => {
    expect(isRetryableConnectError('boom')).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
  });
});
