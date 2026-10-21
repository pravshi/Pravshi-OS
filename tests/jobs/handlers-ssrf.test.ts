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
  looksLikeIpv4Literal,
  parseIpv4Aton,
  parseIpv6Bytes,
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
    // Evasion: encodings WHATWG normalizes to a blocked dotted-quad
    ['http://0x7f.0.0.1/hook', 'hex parts'],
    ['http://0x7f000001/hook', 'single-integer hex'],
    ['http://127.1/hook', 'short form 127.1'],
    ['http://0177.1/hook', 'mixed octal + short form'],
    // Evasion: malformed IP literals WHATWG refuses to classify (its
    // ends-in-a-number heuristic keys off the LAST part only), leaving the
    // string un-normalized as a "hostname" — the guard fails closed on any
    // inet_aton-charset string it cannot strictly parse (PR #68 CI failure).
    ['http://0x7f.0x0.0x0x1/hook', 'hex quad, malformed final part 0x0x1'],
    ['http://127.0.0.08/hook', 'invalid-octal part 08 (WHATWG rejects the URL)'],
    ['http://1.2.3.4x/hook', 'dotted quad with trailing junk'],
    // IPv4-mapped IPv6
    ['http://[::ffff:127.0.0.1]/hook', 'mapped loopback'],
    ['http://[::ffff:10.0.0.1]/hook', 'mapped private'],
    // URL serializes mapped addresses in hex-group form (::ffff:7f00:1) —
    // the dotted-tail text pattern never sees them; bytes are judged.
    ['http://[::ffff:7f00:1]/hook', 'mapped loopback, serialized hex form'],
    ['http://[::ffff:10.10.5.5]/hook', 'mapped private 10.10.5.5'],
    // IPv4-compatible IPv6 (deprecated ::/96): [::127.0.0.1] serializes as [::7f00:1]
    ['http://[::127.0.0.1]/hook', 'compatible loopback'],
    // IPv6 private/link-local
    ['http://[fc00::1]/hook', 'unique-local'],
    ['http://[fe80::1]/hook', 'link-local v6'],
    ['http://[fe90::1]/hook', 'link-local v6 beyond the literal fe80: prefix (fe80::/10)'],
    ['http://[fd00::1]/hook', 'unique-local fd00::/8'],
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
    'http://1.1.1.1/hook', // public dotted-quad literal
    'http://93.184.216.34/hook', // public dotted-quad literal
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
    expect(isBlockedIpLiteral('9.9.9.9')).toBe(false);
    expect(isBlockedIpLiteral('1.1.1.1')).toBe(false);
    expect(isBlockedIpLiteral('93.184.216.34')).toBe(false);
    expect(isBlockedIpLiteral('[2606:4700:4700::1111]')).toBe(false);
    // Mapped/compatible forms of PUBLIC addresses stay allowed.
    expect(isBlockedIpLiteral('[::ffff:93.184.216.34]')).toBe(false);
    expect(isBlockedIpLiteral('::ffff:5db8:d822')).toBe(false); // 93.184.216.34, serialized
    expect(isBlockedIpLiteral('[::8.8.8.8]')).toBe(false);
  });

  it('blocks every IPv4 encoding of a blocked address', () => {
    // Each of these denotes 127.0.0.1 in some parser's grammar.
    for (const host of [
      '127.0.0.1',
      '0x7f.0.0.1', // hex parts
      '0177.0.0.1', // octal parts
      '2130706433', // single-integer decimal
      '0x7f000001', // single-integer hex
      '127.1', // short form
      '0177.1', // mixed octal + short
      '0x7f.1', // mixed hex + short
    ]) {
      expect(isBlockedIpLiteral(host), host).toBe(true);
    }
  });

  it('fails closed on malformed IP literals (parser-differential strings)', () => {
    // WHATWG leaves these un-normalized as "hostnames": the last part
    // defeats its ends-in-a-number heuristic. They are composed purely of
    // inet_aton characters, so no range check would ever engage — block.
    expect(isBlockedIpLiteral('0x7f.0x0.0x0x1')).toBe(true);
    expect(isBlockedIpLiteral('127.0.0.08')).toBe(true); // invalid-octal part
    expect(isBlockedIpLiteral('1.2.3.4x')).toBe(true);
  });

  it('judges IPv6 by parsed bytes, including mapped/compatible unwrapping', () => {
    expect(isBlockedIpLiteral('[::1]')).toBe(true);
    expect(isBlockedIpLiteral('[::]')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:7f00:1')).toBe(true); // mapped 127.0.0.1, hex form
    expect(isBlockedIpLiteral('[::ffff:127.0.0.1]')).toBe(true); // mapped, dotted form
    expect(isBlockedIpLiteral('[::7f00:1]')).toBe(true); // compatible 127.0.0.1
    expect(isBlockedIpLiteral('[fe90::1]')).toBe(true); // fe80::/10, not just fe80:
    expect(isBlockedIpLiteral('[febf::ffff]')).toBe(true); // fe80::/10 upper edge
    expect(isBlockedIpLiteral('[fd12:3456::1]')).toBe(true); // fc00::/7
    expect(isBlockedIpLiteral('[fe80::1%25eth0]')).toBe(true); // zone id stripped
    // Documentation ranges are not globally reachable (IANA special-purpose
    // registry), so they are blocked like the other non-global blocks.
    expect(isBlockedIpLiteral('[2001:db8::1]')).toBe(true);
  });
});

describe('SSRF guard — every non-global range (IANA special-purpose registry)', () => {
  const blockedV4: Array<[string, string]> = [
    ['192.0.0.1', '192.0.0.0/24 IETF protocol assignments'],
    ['192.0.2.1', '192.0.2.0/24 TEST-NET-1'],
    ['198.51.100.1', '198.51.100.0/24 TEST-NET-2'],
    ['203.0.113.5', '203.0.113.0/24 TEST-NET-3'],
    ['198.18.0.1', '198.18.0.0/15 benchmarking, low half'],
    ['198.19.255.254', '198.18.0.0/15 benchmarking, high edge'],
    ['192.88.99.1', '192.88.99.0/24 6to4 relay anycast'],
    ['224.0.0.1', '224.0.0.0/4 multicast'],
    ['239.255.255.250', '224.0.0.0/4 multicast (SSDP), high edge'],
    ['240.0.0.1', '240.0.0.0/4 reserved'],
    ['255.255.255.255', 'limited broadcast'],
    ['4026531841', '240.0.0.1 as a single decimal integer'],
    ['0xe0.0.0.1', '224.0.0.1 with a hex first part'],
  ];
  it.each(blockedV4)('blocks IPv4 %s (%s)', (ip) => {
    expect(isBlockedIpLiteral(ip)).toBe(true);
    expect(checkWebhookUrlStatic(`http://${ip}/hook`).allowed).toBe(false);
  });

  const blockedV6: Array<[string, string]> = [
    ['64:ff9b::7f00:1', 'NAT64 to 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to 169.254.169.254 metadata'],
    ['64:ff9b::10.0.0.1', 'NAT64 to 10.0.0.1, dotted tail'],
    ['64:ff9b:1::1', 'NAT64 local-use 64:ff9b:1::/48'],
    ['::ffff:0:7f00:1', 'SIIT IPv4-translated 127.0.0.1'],
    ['::ffff:0:a9fe:a9fe', 'SIIT IPv4-translated 169.254.169.254'],
    ['2002:7f00:1::', '6to4 wrapping 127.0.0.1'],
    ['2002:808:808::1', '6to4 wrapping a public address — 6to4 is blocked outright'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo 2001::/32'],
    ['2001:2::1', 'benchmarking 2001:2::/48 (inside 2001::/23)'],
    ['2001:db8:1234::1', 'documentation 2001:db8::/32'],
    ['3fff::1', 'documentation 3fff::/20'],
    ['ff02::1', 'multicast ff00::/8, link-local all-nodes'],
    ['ff05::1:3', 'multicast ff00::/8, site-local'],
    ['fec0::1', 'deprecated site-local fec0::/10'],
    ['100::1', 'discard-only 100::/64'],
    ['5f00::1', 'SRv6 SIDs 5f00::/16'],
    ['4000::1', 'unallocated space outside 2000::/3'],
  ];
  // Judged on isBlockedIpLiteral, the check every DNS answer goes through. A
  // URL-level assertion would prove nothing here: see the next test.
  it.each(blockedV6)('blocks IPv6 %s (%s)', (ip) => {
    expect(isBlockedIpLiteral(`[${ip}]`)).toBe(true);
    expect(isBlockedIpLiteral(ip)).toBe(true);
  });

  it('refuses every IPv6-literal URL statically (existing behaviour, unchanged)', () => {
    // The bracketed hostname has no dot, so the single-label rule refuses it
    // before any range check — a public IPv6 literal included. IPv6 targets
    // are reached by name, and their DNS answers are range-checked.
    const result = checkWebhookUrlStatic('http://[2606:4700:4700::1111]/hook');
    expect(result).toEqual({ allowed: false, reason: 'blocked hostname: single-label hostname' });
  });

  it('still allows public addresses, including through NAT64 and SIIT', () => {
    for (const ip of [
      '8.8.8.8',
      '[2606:4700:4700::1111]',
      '[2a00:1450:4001:80b::200e]', // global unicast
      '[64:ff9b::808:808]', // NAT64 to 8.8.8.8 — the embedded address is public
      '[::ffff:0:808:808]', // SIIT 8.8.8.8
      '[2001:200::1]', // first allocation just above 2001::/23
    ]) {
      expect(isBlockedIpLiteral(ip), ip).toBe(false);
    }
  });

  it('keeps the boundaries exact', () => {
    expect(isBlockedIpLiteral('198.17.255.255')).toBe(false); // below 198.18/15
    expect(isBlockedIpLiteral('198.20.0.0')).toBe(false); // above 198.18/15
    expect(isBlockedIpLiteral('223.255.255.255')).toBe(false); // below multicast
    expect(isBlockedIpLiteral('[1fff:ffff::1]')).toBe(true); // just below 2000::/3
    expect(isBlockedIpLiteral('[2001:1ff::1]')).toBe(true); // top of 2001::/23
    expect(isBlockedIpLiteral('[3fff:fff::1]')).toBe(true); // top of 3fff::/20
    expect(isBlockedIpLiteral('[3fff:1000::1]')).toBe(false); // just above 3fff::/20
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

  it('rejects malformed parts instead of truncating them', () => {
    // '0x0x1': the second 0x is not a hex digit — the part is unparseable,
    // which is precisely why WHATWG refuses to classify 0x7f.0x0.0x0x1.
    expect(parseIpv4Aton('0x7f.0x0.0x0x1')).toBeNull();
    // '08'/'09' are invalid octal; parseInt would silently have read 0.
    expect(parseIpv4Aton('127.0.0.08')).toBeNull();
    expect(parseIpv4Aton('09.1.1.1')).toBeNull();
    expect(parseIpv4Aton('0x.1.1.1')).toBeNull(); // 0x with no digits
  });
});

describe('looksLikeIpv4Literal', () => {
  it('flags inet_aton-charset strings with digits', () => {
    expect(looksLikeIpv4Literal('0x7f.0x0.0x0x1')).toBe(true);
    expect(looksLikeIpv4Literal('1.2.3.4x')).toBe(true);
  });

  it('does not flag real DNS names', () => {
    expect(looksLikeIpv4Literal('example.com')).toBe(false); // 'o'/'m' outside the charset
    expect(looksLikeIpv4Literal('hooks.slack.com')).toBe(false);
    expect(looksLikeIpv4Literal('dead.beef')).toBe(false); // hex letters but no digit
    expect(looksLikeIpv4Literal('a1.example.com')).toBe(false); // charset judged on whole string
  });
});

describe('parseIpv6Bytes', () => {
  it('parses compressed, full, and dotted-tail forms to the same bytes', () => {
    expect(parseIpv6Bytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6Bytes('0:0:0:0:0:0:0:1')).toEqual(parseIpv6Bytes('::1'));
    expect(parseIpv6Bytes('::ffff:127.0.0.1')).toEqual(parseIpv6Bytes('::ffff:7f00:1'));
    expect(parseIpv6Bytes('[fe80::1%25eth0]')).toEqual(parseIpv6Bytes('fe80::1'));
  });

  it('returns null for non-IPv6 input', () => {
    expect(parseIpv6Bytes('127.0.0.1')).toBeNull();
    expect(parseIpv6Bytes('example.com')).toBeNull();
    expect(parseIpv6Bytes('1::2::3')).toBeNull();
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

  it('blocks every name under .localhost and .home.arpa', () => {
    expect(isBlockedHostname('api.localhost')).toBeTruthy(); // RFC 6761: loopback
    expect(isBlockedHostname('a.b.LOCALHOST.')).toBeTruthy(); // case and trailing dot
    expect(isBlockedHostname('nas.home.arpa')).toBeTruthy(); // RFC 8375: private network
    expect(checkWebhookUrlStatic('http://admin.localhost:8080/hook').allowed).toBe(false);
    expect(isBlockedHostname('localhost.example.com')).toBeNull(); // label boundary
  });

  it('allows normal public hostnames', () => {
    expect(isBlockedHostname('example.com')).toBeNull();
    expect(isBlockedHostname('hooks.slack.com')).toBeNull();
    // Suffix match must be on a label boundary: notinternal.com is fine.
    expect(isBlockedHostname('notinternal.com')).toBeNull();
  });
});
