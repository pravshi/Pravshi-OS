/**
 * Phase 3, S-6 — the sign-in lockout check fails CLOSED, and lockout bookkeeping
 * failures alert instead of disappearing into a console line.
 *
 * No database: the auth-plane client is mocked to fail or answer as each case
 * needs, and Sentry is mocked so the alert itself is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, captureException } = vi.hoisted(() => ({
  execute: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute } }));
vi.mock('@sentry/nextjs', () => ({ captureException }));

import {
  clearLoginLockout,
  isLockedOut,
  noteLoginFailure,
  noteLoginSuccess,
} from '@/lib/auth/login-lockout';
import { resetAuthAlertLimiter } from '@/lib/auth/safe-log';

const EXISTING = 'known.user@example.com';
const UNKNOWN = 'nobody-here@example.com';

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  execute.mockReset();
  captureException.mockReset();
  resetAuthAlertLimiter();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** Everything the failure path wrote anywhere: log lines and alert payloads. */
function emitted(): string {
  return JSON.stringify([consoleError.mock.calls, captureException.mock.calls], (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
}

describe('isLockedOut — fails closed', () => {
  it('answers from the database when the check works', async () => {
    execute.mockResolvedValueOnce({ rows: [{ locked: false }] });
    expect(await isLockedOut(EXISTING)).toBe(false);
    execute.mockResolvedValueOnce({ rows: [{ locked: true }] });
    expect(await isLockedOut(EXISTING)).toBe(true);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('treats a failed check as locked and alerts', async () => {
    execute.mockRejectedValueOnce(
      Object.assign(new Error(`connection lost while checking ${EXISTING}`), { code: '08006' }),
    );
    expect(await isLockedOut(EXISTING)).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain(
      'auth.login.lockout_check_failed',
    );
  });

  it('treats a check that returns no row, or no boolean, as locked and alerts', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    expect(await isLockedOut(EXISTING)).toBe(true);
    execute.mockResolvedValueOnce({ rows: [{ locked: null }] });
    expect(await isLockedOut(EXISTING)).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('answers the same for an existing and an unknown account when the check fails', async () => {
    execute.mockRejectedValue(new Error('database unavailable'));
    expect(await isLockedOut(EXISTING)).toBe(true);
    expect(await isLockedOut(UNKNOWN)).toBe(true);
  });

  it('never puts the email into a log line or an alert', async () => {
    execute.mockRejectedValueOnce(new Error(`could not check ${EXISTING}`));
    await isLockedOut(EXISTING);
    expect(emitted()).not.toContain(EXISTING);
    expect(emitted()).not.toContain('known.user');
  });

  it('never throws', async () => {
    execute.mockRejectedValueOnce('not even an Error');
    await expect(isLockedOut(EXISTING)).resolves.toBe(true);
  });
});

describe('lockout bookkeeping — failures alert, never throw', () => {
  it('a failed failure-record raises an alert', async () => {
    execute.mockRejectedValueOnce(new Error('record failed'));
    await expect(noteLoginFailure(EXISTING, '203.0.113.7', 'ua')).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain(
      'auth.login.failure_record_failed',
    );
    expect(emitted()).not.toContain(EXISTING);
  });

  it('a failed clear raises an alert, through both callers', async () => {
    execute.mockRejectedValue(new Error('clear failed'));
    await expect(clearLoginLockout(EXISTING)).resolves.toBeUndefined();
    await expect(noteLoginSuccess(EXISTING)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain(
      'auth.login.lockout_clear_failed',
    );
  });

  it('successful bookkeeping raises nothing', async () => {
    execute.mockResolvedValue({ rows: [] });
    await noteLoginFailure(EXISTING, null, null);
    await noteLoginSuccess(EXISTING);
    expect(captureException).not.toHaveBeenCalled();
  });
});
