/**
 * Phase 3, A1 review (F-B1-1, F-B1-2) — the client address behind rate limiting and
 * lockout recording is validated, and rate-limit buckets group IPv6 by /64.
 *
 * An unvalidated x-forwarded-for value used to flow into `::inet` casts (a forged
 * value made the lockout recorder throw, so failures stopped counting) and into
 * rate-limit keys (a forged or rotating value bought a fresh bucket per request).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute: vi.fn() } }));

import { clientIp, forwardedIp } from '@/lib/auth/login-events';
import { ipRateLimitKey, rateLimitSubject } from '@/lib/auth/rate-limit';

describe('forwardedIp — only a valid address, else null', () => {
  it('takes the first entry when it is a valid address', () => {
    expect(forwardedIp('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7');
    expect(forwardedIp(' 2001:db8::1 ,10.0.0.1')).toBe('2001:db8::1');
    expect(forwardedIp('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
  });

  it.each([
    ['x', 'a forged token'],
    ['not-an-ip, 203.0.113.7', 'garbage first, valid later (only the first entry counts)'],
    ['203.0.113.7.5', 'too many parts'],
    ['999.1.1.1', 'out-of-range octet'],
    ['fe80::1%eth0', 'zone id (Postgres inet refuses it)'],
    ["1.2.3.4'; drop table x;--", 'injection-shaped'],
    ['', 'empty'],
  ])('rejects %j (%s)', (value) => {
    expect(forwardedIp(value)).toBeNull();
  });

  it('absent header is null', () => {
    expect(forwardedIp(null)).toBeNull();
    expect(forwardedIp(undefined)).toBeNull();
  });

  it('clientIp applies the same rule to a request', () => {
    const req = (xff?: string) =>
      new Request('http://localhost/x', { headers: xff ? { 'x-forwarded-for': xff } : {} });
    expect(clientIp(req('198.51.100.4, 10.0.0.1'))).toBe('198.51.100.4');
    expect(clientIp(req('x'))).toBeNull();
    expect(clientIp(req())).toBeNull();
  });
});

describe('rateLimitSubject — one bucket per client, IPv6 per /64', () => {
  it('rotating within one /64 never buys a fresh bucket', () => {
    const subjects = ['2001:db8:1:2::1', '2001:db8:1:2::ffff', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'];
    expect(new Set(subjects.map(rateLimitSubject))).toEqual(new Set(['2001:db8:1:2::/64']));
  });

  it('different /64s are different buckets', () => {
    expect(rateLimitSubject('2001:db8:1:2::1')).not.toBe(rateLimitSubject('2001:db8:1:3::1'));
  });

  it('every spelling of one IPv6 /64 maps to the same subject', () => {
    expect(rateLimitSubject('2001:0db8:0001:0002:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:db8:1:2::203.0.113.7')).toBe('2001:db8:1:2::/64');
  });

  it('an IPv4-mapped address is its IPv4 address', () => {
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSubject('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
  });

  it('absent or invalid addresses share one bucket', () => {
    expect(rateLimitSubject(null)).toBe('unknown');
    expect(rateLimitSubject('x')).toBe('unknown');
    expect(ipRateLimitKey('login', 'not-an-ip')).toBe('login:unknown');
  });

  it('keys stay inside their route namespace', () => {
    expect(ipRateLimitKey('login', '2001:db8::1')).toBe('login:2001:db8:0:0::/64');
    expect(ipRateLimitKey('invite:accept', '198.51.100.9')).toBe('invite:accept:198.51.100.9');
  });
});
