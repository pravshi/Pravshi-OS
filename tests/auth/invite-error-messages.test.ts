import { describe, expect, it } from 'vitest';
import {
  INVITE_PASSWORD_GUIDANCE,
  inviteAcceptErrorMessage,
} from '@/lib/invitations/error-messages';

/**
 * Invitation-accept error copy (AUD-02) — pure, DB-free.
 *
 * The defect was a lie of omission: every failure except PASSWORD_TOO_SHORT
 * was reported as "invitation invalid, expired, or already used". These tests
 * pin the replacement behaviour: every code the server can produce maps to a
 * distinct, accurate message, and no password problem is ever phrased as an
 * invitation problem.
 */
const ALL_CODES = [
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'PASSWORD_TOO_COMMON',
  'PASSWORD_BREACHED',
  'INVITATION_CANNOT_COMPLETE',
  'INVITATION_INVALID',
  'RATE_LIMITED',
  'INVALID_REQUEST',
] as const;

describe('inviteAcceptErrorMessage', () => {
  it('maps every server code to a distinct message', () => {
    const messages = ALL_CODES.map((code) => inviteAcceptErrorMessage(code));
    expect(new Set(messages).size).toBe(ALL_CODES.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });

  it('never blames the invitation for a password problem', () => {
    for (const code of [
      'PASSWORD_TOO_SHORT',
      'PASSWORD_TOO_LONG',
      'PASSWORD_TOO_COMMON',
      'PASSWORD_BREACHED',
    ] as const) {
      const message = inviteAcceptErrorMessage(code).toLowerCase();
      expect(message).toContain('password');
      expect(message).not.toContain('invitation link is invalid');
      expect(message).not.toContain('already used');
    }
  });

  it('states the real policy numbers for length failures', () => {
    expect(inviteAcceptErrorMessage('PASSWORD_TOO_SHORT')).toContain('12');
    expect(inviteAcceptErrorMessage('PASSWORD_TOO_LONG')).toContain('128');
  });

  it('names the breach for a breached password', () => {
    expect(inviteAcceptErrorMessage('PASSWORD_BREACHED').toLowerCase()).toContain('breach');
  });

  it('keeps INVITATION_INVALID deliberately coarse — no probing signal', () => {
    const message = inviteAcceptErrorMessage('INVITATION_INVALID');
    expect(message).toContain('invalid, expired, or already used');
  });

  it('falls back to a generic message for unknown or missing codes', () => {
    const fallback = inviteAcceptErrorMessage(undefined);
    expect(fallback).toBe(inviteAcceptErrorMessage(null));
    expect(fallback).toBe(inviteAcceptErrorMessage('SOME_FUTURE_CODE'));
    expect(fallback.toLowerCase()).not.toContain('invitation');
  });

  it('the on-form guidance states the same policy the mapper enforces', () => {
    expect(INVITE_PASSWORD_GUIDANCE).toContain('12');
    expect(INVITE_PASSWORD_GUIDANCE.toLowerCase()).toContain('breach');
  });
});
