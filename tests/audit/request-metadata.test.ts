/**
 * Phase 3, F-SEC-B1-5 — the client address an audit entry records is either a value
 * Postgres `inet` accepts or NULL. Node's isIP() accepts an IPv6 zone id
 * (fe80::1%eth0) that the `::inet` cast in writeAuditEntry() rejects, which would
 * throw and lose the audit entry; a forged x-forwarded-for must not be able to do that.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb: vi.fn() }));

import { requestMetadata } from '@/lib/audit/log';

const meta = (xff?: string) =>
  requestMetadata(
    new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff }),
    '00000000-0000-4000-8000-000000000001',
  );

describe('requestMetadata — client address', () => {
  it('keeps a valid first-hop address', () => {
    expect(meta('203.0.113.7, 10.0.0.1').ip).toBe('203.0.113.7');
    expect(meta('2001:db8::1').ip).toBe('2001:db8::1');
    expect(meta('::ffff:203.0.113.7').ip).toBe('::ffff:203.0.113.7');
  });

  it.each([
    ['fe80::1%eth0', 'a link-local zone id'],
    ['fe80::1%25eth0', 'a URL-encoded zone id'],
    ['::ffff:1.2.3.4%x', 'a zone id on a mapped address'],
    ['x', 'a forged token'],
    ['1.2.3.4:80', 'an address with a port'],
    ['', 'empty'],
  ])('drops %j (%s)', (value) => {
    expect(meta(value).ip).toBeNull();
  });

  it('absent header is null', () => {
    expect(meta().ip).toBeNull();
  });
});
