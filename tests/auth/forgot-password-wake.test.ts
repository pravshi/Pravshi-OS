/**
 * WP-W — the forgot-password route wakes the worker (so the reset email, a job, goes out in
 * seconds) on EVERY path through the reset step: known address, unknown address, throttled,
 * failed. A wake sent only when an account exists would hand back the timing oracle that
 * moving the email onto the job plane removed (Phase 11, F-11-06). DB-free.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  requestWorkerWake: vi.fn(async () => 'sent'),
}));

vi.mock('@/lib/auth/password-reset', () => {
  class PasswordResetError extends Error {
    constructor(public code: string) {
      super(code);
    }
  }
  return { requestPasswordReset: hoisted.requestPasswordReset, PasswordResetError };
});
vi.mock('@/lib/jobs/wake', () => ({ requestWorkerWake: hoisted.requestWorkerWake }));

import { POST } from '@/app/api/auth/forgot-password/route';
import { PasswordResetError } from '@/lib/auth/password-reset';

const post = (body: string) =>
  POST(
    new Request('http://localhost:3000/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );

beforeEach(() => {
  hoisted.requestPasswordReset.mockReset();
  hoisted.requestWorkerWake.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('forgot-password wakes the worker on every path', () => {
  const cases: Array<[string, () => void]> = [
    ['an address with a login', () => hoisted.requestPasswordReset.mockResolvedValue({ ok: true })],
    ['an unknown address', () => hoisted.requestPasswordReset.mockResolvedValue({ ok: true })],
    [
      'a throttled request',
      () =>
        hoisted.requestPasswordReset.mockRejectedValue(
          new (PasswordResetError as unknown as new (code: string) => Error)('RATE_LIMITED'),
        ),
    ],
    [
      'an internal failure',
      () => hoisted.requestPasswordReset.mockRejectedValue(new Error('db down')),
    ],
  ];

  it.each(cases)('%s → 200 { ok: true } and exactly one wake', async (_name, arrange) => {
    arrange();
    const res = await post(JSON.stringify({ email: 'someone@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hoisted.requestWorkerWake).toHaveBeenCalledTimes(1);
  });

  it('wakes only after the reset step has finished (the job is committed first)', async () => {
    const order: string[] = [];
    hoisted.requestPasswordReset.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('reset');
      return { ok: true };
    });
    hoisted.requestWorkerWake.mockImplementation(async () => {
      order.push('wake');
      return 'sent';
    });
    await post(JSON.stringify({ email: 'someone@example.com' }));
    expect(order).toEqual(['reset', 'wake']);
  });
});
