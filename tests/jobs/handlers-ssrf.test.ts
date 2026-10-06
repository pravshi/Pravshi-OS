/**
 * Phase 6 — SSRF guard unit tests (Job Handler Engineer).
 *
 * Pure-function tests: no network, no DNS, no database. Every blocked case
 * exercises checkWebhookUrlStatic / isBlockedIpLiteral / isBlockedHostname,
 * which run before any DNS lookup or TCP connection in the real path
 * (assertWebhookTargetAllowed → fetchWebhookPinned with pinned IP).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/jobs/worker', () => ({
  registerHandler: vi.fn(),
}));

import {
  checkWebhookUrlStatic,
  isBlockedHostname,
  isBlockedIpLiteral,
  parseIpv4Aton,
} from '../../src/lib/jobs/handlers';

describe('SSRF guard — blocked URLs (static check, no DNS)', () => {
  const blocked: Array<[string, string]> = [
    // Private ranges (contract §6)
    ['http://10.0.0.5/hook', '10/8'],
    ['http://10.255.255.255/hook', '10/8 edge'],
    ['http://172.16.0.1/hook', '172.16/12 start'],
    ['http://172.31.255.254/hook', '172.16/12 end'],
    ['http://192.168.1.1/hook', '192.168/16'],
    // Loopback
    ['http://127.0.0.1:3000/hook', '127/8'],
    ['http://127.1.2.3/hook', '127/8 non-.1'],
    ['http://[::1]/hook', 'IPv6 loopback'],
    // Cloud metadata / link-local
    ['http://169.254.169.254/latest/meta-data', 'metadata endpoint'],
    ['http://169.254.10.20/hook', 'link-local'],
    // Internal hostnames (contract §6)
    ['http://service.internal/hook', '.internal'],
    ['http://db.prod.internal:5432/hook', 'nested .internal'],
    ['http://printer.local/hook', '.local'],
    // Localhost by name
    ['http://localhost:8080/hook', 'localhost'],
    // Evasion: non-standard IPv4 literal forms
    ['http://2130706433/hook', 'decimal 2130706433 = 127.0.0.1'],
    ['http://0x7f.0x0.0x0.0x1/hook', 'hex form of 127.0.0.1'],
    ['http://0177.0.0.1/hook', 'octal form of 127.0.0.1'],
    ['http://3232235521/hook', 'decimal 3232235521 = 192.168.0.1'],
    // IPv4-mapped IPv6
    ['http://[::ffff:127.0.0.1]/hook', 'mapped loopback'],
    ['http://[::ffff:10.0.0.1]/hook', 'mapped private'],
    // IPv6 private/link-local
    ['http://[fc00::1]/hook', 'unique-local'],
    ['http://[fe80::1]/hook', 'link-local v6'],
    // Unspecified
    ['http://0.0.0.0/hook', '0.0.0.0'],
    // Scheme allowlist
    ['ftp://example.com/hook', 'ftp scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://example.com/', 'gopher scheme'],
    // Userinfo smuggling
    ['http://user:pass@example.com/hook', 'userinfo'],
    // Malformed
    ['not-a-url', 'unparseable'],
    ['http://[::1/hook', 'bad bracket'],
    // Single-label hostnames (could resolve via search domains to internal)
    ['http://intranet/hook', 'single-label'],
  ];

  it.each(blocked)('blocks %s (%s)', (url) => {
    const result = checkWebhookUrlStatic(url);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('blocks every case above — count sanity', () => {
    expect(blocked.length).toBeGreaterThanOrEqual(10);
  });
});

describe('SSRF guard — allowed URLs', () => {
  const allowed = [
    'https://example.com/hook',
    'http://example.com/hook',
    'https://hooks.slack.com/services/T000/B000/XXXX',
    'https://api.example.co.uk:8443/v1/events?x=1',
    'http://203.0.113.5/hook', // TEST-NET-3 documentation range: not private
    'https://sub.domain.example.io/a/b',
  ];

  it.each(allowed)('allows %s', (url) => {
    expect(checkWebhookUrlStatic(url)).toEqual({ allowed: true });
  });
});

describe('isBlockedIpLiteral', () => {
  it('detects blocked IPv4 literals including aton evasions', () => {
    expect(isBlockedIpLiteral('10.1.2.3')).toBe(true);
    expect(isBlockedIpLiteral('172.20.10.4')).toBe(true);
    expect(isBlockedIpLiteral('192.168.0.1')).toBe(true);
    expect(isBlockedIpLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('169.254.169.254')).toBe(true);
    expect(isBlockedIpLiteral('100.64.0.1')).toBe(true); // CGNAT
    expect(isBlockedIpLiteral('0.0.0.0')).toBe(true);
    expect(isBlockedIpLiteral('2130706433')).toBe(true); // 127.0.0.1
    expect(isBlockedIpLiteral('0x7f.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('0177.0.0.1')).toBe(true);
    // Bracketed forms (as they appear in URLs) are unwrapped first.
    expect(isBlockedIpLiteral('[::1]')).toBe(true);
    expect(isBlockedIpLiteral('[::ffff:192.168.1.1]')).toBe(true);
    expect(isBlockedIpLiteral('[fc00::99]')).toBe(true);
  });

  it('allows public IPv4/IPv6 literals', () => {
    expect(isBlockedIpLiteral('8.8.8.8')).toBe(false);
    expect(isBlockedIpLiteral('203.0.113.9')).toBe(false);
    expect(isBlockedIpLiteral('1.1.1.1')).toBe(false);
    expect(isBlockedIpLiteral('[2606:4700:4700::1111]')).toBe(false);
  });

  it('returns false for non-IP hostnames (DNS path handles those)', () => {
    expect(isBlockedIpLiteral('example.com')).toBe(false);
    expect(isBlockedIpLiteral('evil.internal')).toBe(false);
  });
});

describe('parseIpv4Aton', () => {
  it('parses dotted, decimal, hex, and octal forms', () => {
    expect(parseIpv4Aton('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Aton('2130706433')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Aton('0x7f.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Aton('0177.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4Aton('3232235777')).toEqual([192, 168, 1, 1]);
  });

  it('rejects non-IPv4 input', () => {
    expect(parseIpv4Aton('example.com')).toBeNull();
    expect(parseIpv4Aton('')).toBeNull();
    expect(parseIpv4Aton('1.2.3.4.5')).toBeNull();
    expect(parseIpv4Aton('999.1.1.1')).toBeNull();
  });
});

describe('isBlockedHostname', () => {
  it('blocks internal/local/localhost/single-label names', () => {
    expect(isBlockedHostname('localhost')).toBeTruthy();
    expect(isBlockedHostname('svc.internal')).toBeTruthy();
    expect(isBlockedHostname('printer.local')).toBeTruthy();
    expect(isBlockedHostname('intranet')).toBeTruthy();
    expect(isBlockedHostname('LOCALHOST')).toBeTruthy(); // case-insensitive
  });

  it('allows normal public hostnames', () => {
    expect(isBlockedHostname('example.com')).toBeNull();
    expect(isBlockedHostname('hooks.slack.com')).toBeNull();
    // Suffix match must be on a label boundary: notinternal.com is fine.
    expect(isBlockedHostname('notinternal.com')).toBeNull();
  });
});
