import { describe, expect, it } from 'vitest';
import { loginPathForNext, safeNextPath } from '@/lib/auth/next-path';

/**
 * The post-login return path validator (AUD-21) — pure, DB-free.
 *
 * The threat model is the open redirect: /login?next=... is attacker-
 * controllable (any link can carry it), so the validator is the whole
 * defence. Every rejection class gets a case; so does every shape the app
 * itself produces, which must keep working.
 */
describe('safeNextPath', () => {
  it('accepts ordinary application paths, with or without query strings', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/crm/deals')).toBe('/crm/deals');
    expect(safeNextPath('/crm/deals/abc-123?tab=notes')).toBe('/crm/deals/abc-123?tab=notes');
    expect(safeNextPath('/work/projects/x#tasks')).toBe('/work/projects/x#tasks');
    expect(safeNextPath('/search?q=a%20b')).toBe('/search?q=a%20b');
  });

  it('rejects absolute and protocol-relative URLs — the open-redirect shapes', () => {
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('http://evil.example/path')).toBeNull();
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('//evil.example/path')).toBeNull();
    expect(safeNextPath('///evil.example')).toBeNull();
    expect(safeNextPath('javascript:alert(1)')).toBeNull();
  });

  it('rejects backslash tricks that some parsers read as host separators', () => {
    expect(safeNextPath('/\\evil.example')).toBeNull();
    expect(safeNextPath('\\/evil.example')).toBeNull();
    expect(safeNextPath('/crm\\deals')).toBeNull();
  });

  it('rejects empty, relative-without-slash, and non-string input', () => {
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath('crm/deals')).toBeNull();
  });

  it('rejects whitespace and control characters anywhere in the value', () => {
    expect(safeNextPath('/crm deals')).toBeNull();
    expect(safeNextPath('/crm\tdeals')).toBeNull();
    expect(safeNextPath('/crm\ndeals')).toBeNull();
    expect(safeNextPath(' /crm/deals')).toBeNull();
  });

  it('rejects the authentication surface itself — returning there is a loop', () => {
    expect(safeNextPath('/login')).toBeNull();
    expect(safeNextPath('/login?next=/crm')).toBeNull();
    expect(safeNextPath('/mfa')).toBeNull();
    expect(safeNextPath('/forgot-password')).toBeNull();
    expect(safeNextPath('/reset-password')).toBeNull();
    expect(safeNextPath('/invite')).toBeNull();
    expect(safeNextPath('/access-denied')).toBeNull();
  });

  it('does not over-reject paths that merely start with similar segments', () => {
    expect(safeNextPath('/logins')).toBe('/logins');
    expect(safeNextPath('/invited-users')).toBe('/invited-users');
  });
});

describe('loginPathForNext', () => {
  it('carries a safe deep link, URL-encoded', () => {
    expect(loginPathForNext('/crm/deals')).toBe('/login?next=%2Fcrm%2Fdeals');
    expect(loginPathForNext('/work/tasks?mine=1')).toBe('/login?next=%2Fwork%2Ftasks%3Fmine%3D1');
  });

  it('is the bare /login for the default destination and for unsafe input', () => {
    expect(loginPathForNext('/')).toBe('/login');
    expect(loginPathForNext(null)).toBe('/login');
    expect(loginPathForNext(undefined)).toBe('/login');
    expect(loginPathForNext('https://evil.example')).toBe('/login');
    expect(loginPathForNext('//evil.example')).toBe('/login');
  });
});
