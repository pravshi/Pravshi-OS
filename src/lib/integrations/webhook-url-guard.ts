/**
 * Static webhook-URL guard (SSRF): scheme, userinfo, blocked host suffixes and blocked IP literals
 * in every inet_aton form. Pure functions, no DNS and no network.
 *
 * It lives with the integrations module, which owns webhook URLs: subscription create/update
 * validates a URL here fail-fast (src/lib/integrations/subscriptions.ts), and the worker's webhook
 * delivery (apps/worker/src/handlers.ts) runs the same checks again at send time and adds DNS
 * resolution and connection pinning. The code below is unchanged from its former home in the job
 * handlers; moving it keeps the integrations module from importing the worker (ADR-010).
 */
import { isIP } from 'node:net';

export interface SsrfCheck {
  allowed: boolean;
  reason?: string;
}

// .localhost: RFC 6761 reserves every name under it for loopback.
// .home.arpa: RFC 8375 residential networks — always a private address.
const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa'];

/**
 * Convert an IPv4 address in any inet_aton form to 4 bytes.
 * Handles: dotted decimal, octal (0177.0.0.1), hex (0x7f.0.0.1),
 * and bare 32-bit integers ('2130706433' → 127.0.0.1).
 * Returns null when the string is not an IPv4 literal.
 */
export function parseIpv4Aton(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 10) return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    // A leading-zero part containing 8/9 is invalid octal: WHATWG's IPv4
    // parser and inet_aton both reject it outright. Never let parseInt
    // silently truncate it into a different address ('08' → 0).
    else if (/^0[0-9]/.test(p)) return null;
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  let v: number;
  const n0 = nums[0] as number;
  const n1 = nums[1] as number | undefined;
  const n2 = nums[2] as number | undefined;
  const n3 = nums[3] as number | undefined;
  if (nums.length === 1) v = n0;
  else if (nums.length === 2 && n1 !== undefined) {
    if (n0 > 0xff || n1 > 0xffffff) return null;
    v = (n0 << 24) + n1;
  } else if (nums.length === 3 && n1 !== undefined && n2 !== undefined) {
    if (n0 > 0xff || n1 > 0xff || n2 > 0xffff) return null;
    v = (n0 << 24) + (n1 << 16) + n2;
  } else if (nums.length === 4 && n1 !== undefined && n2 !== undefined && n3 !== undefined) {
    if (nums.some((n) => n > 0xff)) return null;
    v = (n0 << 24) + (n1 << 16) + (n2 << 8) + n3;
  } else {
    return null;
  }
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function ipv4ToNumber(b: [number, number, number, number]): number {
  return (b[0] * 256 ** 3 + b[1] * 256 ** 2 + b[2] * 256 + b[3]) >>> 0;
}

function inCidr(
  b: [number, number, number, number],
  base: [number, number, number, number],
  bits: number,
): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(b) & mask) === (ipv4ToNumber(base) & mask);
}

/** Blocked IPv4 ranges: every IANA special-purpose block that is not globally
 *  reachable — private, loopback, link-local (covers 169.254.169.254), CGNAT,
 *  unspecified, protocol assignments, documentation, benchmarking — plus
 *  multicast and the reserved 240/4 space (which holds 255.255.255.255). */
const BLOCKED_V4: Array<[[number, number, number, number], number, string]> = [
  [[10, 0, 0, 0], 8, '10.0.0.0/8 (private)'],
  [[172, 16, 0, 0], 12, '172.16.0.0/12 (private)'],
  [[192, 168, 0, 0], 16, '192.168.0.0/16 (private)'],
  [[127, 0, 0, 0], 8, '127.0.0.0/8 (loopback)'],
  [[0, 0, 0, 0], 8, '0.0.0.0/8 (unspecified)'],
  [[169, 254, 0, 0], 16, '169.254.0.0/16 (link-local; includes 169.254.169.254 metadata)'],
  [[100, 64, 0, 0], 10, '100.64.0.0/10 (CGNAT)'],
  [[192, 0, 0, 0], 24, '192.0.0.0/24 (IETF protocol assignments)'],
  [[192, 0, 2, 0], 24, '192.0.2.0/24 (TEST-NET-1 documentation)'],
  [[198, 51, 100, 0], 24, '198.51.100.0/24 (TEST-NET-2 documentation)'],
  [[203, 0, 113, 0], 24, '203.0.113.0/24 (TEST-NET-3 documentation)'],
  [[198, 18, 0, 0], 15, '198.18.0.0/15 (benchmarking)'],
  [[192, 88, 99, 0], 24, '192.88.99.0/24 (deprecated 6to4 relay anycast)'],
  [[224, 0, 0, 0], 4, '224.0.0.0/4 (multicast)'],
  [[240, 0, 0, 0], 4, '240.0.0.0/4 (reserved; includes 255.255.255.255 broadcast)'],
];

/**
 * IPv6 is judged by allowlist: only global unicast 2000::/3 may be reached,
 * so loopback, unspecified, link-local, site-local, unique-local, multicast,
 * discard-only, NAT64 local-use, SRv6 and any future non-global allocation
 * outside 2000::/3 fail closed. These are the non-global blocks INSIDE it.
 */
const BLOCKED_V6_IN_GLOBAL: Array<[number[], number, string]> = [
  [[0x20, 0x01, 0x00], 23, '2001::/23 (IETF protocol assignments; includes Teredo 2001::/32)'],
  [[0x20, 0x01, 0x0d, 0xb8], 32, '2001:db8::/32 (documentation)'],
  [[0x20, 0x02], 16, '2002::/16 (6to4)'],
  [[0x3f, 0xff, 0x00], 20, '3fff::/20 (documentation)'],
];

function inV6Prefix(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 8) {
    const take = Math.min(8, bits - i);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i / 8] as number) & mask) !== ((prefix[i / 8] ?? 0) & mask)) return false;
  }
  return true;
}

/**
 * True when a host string is composed solely of inet_aton characters
 * (digits, hex letters a–f, the 0x prefix marker, dots) and contains at
 * least one digit. Such a string is an IP-literal ATTEMPT, never a plausible
 * public DNS name: every character in it is meaningful to an IPv4 parser,
 * so when the strict parsers (WHATWG URL, parseIpv4Aton) refuse it, it sits
 * exactly in the parser-differential gap this guard exists to close.
 */
export function looksLikeIpv4Literal(host: string): boolean {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return false;
  if (!/[0-9]/.test(host)) return false;
  return host.split('.').every((label) => label.length > 0);
}

/**
 * Parse an IPv6 literal (brackets, zone id, and dotted-quad tail all
 * tolerated) into its 16 bytes. Returns null when the input is not a valid
 * IPv6 address. Range checks run on the bytes, never on the textual form:
 * `new URL()` serializes [::ffff:127.0.0.1] as [::ffff:7f00:1], so any
 * text-pattern check for the dotted tail silently misses the mapped form.
 */
export function parseIpv6Bytes(host: string): number[] | null {
  let h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  if (isIP(h) !== 6) return null;

  // Rewrite a dotted-quad tail as its two hex groups, then parse uniformly.
  if (h.includes('.')) {
    const lastColon = h.lastIndexOf(':');
    if (lastColon === -1) return null;
    const tail = h.slice(lastColon + 1);
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return null;
    const quad = tail.split('.').map(Number);
    if (quad.some((n) => n > 255)) return null;
    const hi = (((quad[0] as number) << 8) | (quad[1] as number)).toString(16);
    const lo = (((quad[2] as number) << 8) | (quad[3] as number)).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] as string);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tailGroups = parseGroups(halves[1] as string);
    if (tailGroups === null) return null;
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null; // '::' must compress at least one group
    groups = [...head, ...new Array<number>(missing).fill(0), ...tailGroups];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * True when an IPv4 literal (any inet_aton form) or IPv6 literal is blocked.
 * IPv6 forms that carry an IPv4 address in their last 32 bits — IPv4-mapped
 * (::ffff:0:0/96), IPv4-compatible (::/96), SIIT IPv4-translated
 * (::ffff:0:0:0/96) and NAT64 well-known (64:ff9b::/96) — are unwrapped and
 * judged by that IPv4 address; every other IPv6 address must be global
 * unicast (see BLOCKED_V6_IN_GLOBAL). A string that is not
 * a valid literal but is composed purely of inet_aton characters (see
 * looksLikeIpv4Literal) is a malformed IP literal and fails closed: e.g.
 * 0x7f.0x0.0x0x1, whose final part defeats WHATWG's ends-in-a-number
 * heuristic, so `new URL()` leaves it un-normalized, masquerading as a DNS
 * hostname that no IP range check would ever engage on.
 */
export function isBlockedIpLiteral(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  const v4 = parseIpv4Aton(h);
  if (v4) {
    return BLOCKED_V4.some(([base, bits]) => inCidr(v4, base, bits));
  }

  if (h.includes(':')) {
    const b = parseIpv6Bytes(h);
    if (!b) return true; // colon-bearing but not parseable IPv6: fail closed
    const byte = (i: number): number => b[i] as number;
    const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
    // :: (unspecified) and ::1 (loopback)
    if (zero(0, 15) && (byte(15) === 0 || byte(15) === 1)) return true;
    // Forms that embed an IPv4 address in the last 32 bits: judge that
    // address by the IPv4 ranges (a NAT64 path to 169.254.169.254 is still
    // the metadata endpoint).
    const embedded = `${byte(12)}.${byte(13)}.${byte(14)}.${byte(15)}`;
    const mapped = zero(0, 10) && byte(10) === 0xff && byte(11) === 0xff; // ::ffff:0:0/96
    const compatible = zero(0, 12); // ::/96 (deprecated)
    const siit = zero(0, 8) && byte(8) === 0xff && byte(9) === 0xff && zero(10, 12); // ::ffff:0:0:0/96
    const nat64 = byte(0) === 0x00 && byte(1) === 0x64 && byte(2) === 0xff && byte(3) === 0x9b;
    if (mapped || compatible || siit || (nat64 && zero(4, 12))) {
      return isBlockedIpLiteral(embedded);
    }
    // Everything else must be global unicast 2000::/3 — this also blocks
    // fe80::/10, fec0::/10, fc00::/7, ff00::/8, 100::/64, 5f00::/16 and the
    // NAT64 local-use 64:ff9b:1::/48 — and outside the non-global sub-blocks.
    if ((byte(0) & 0xe0) !== 0x20) return true;
    return BLOCKED_V6_IN_GLOBAL.some(([prefix, bits]) => inV6Prefix(b, prefix, bits));
  }

  // Malformed IP literal (see header): fail closed.
  if (looksLikeIpv4Literal(h)) return true;
  return false;
}

export function isBlockedHostname(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return 'localhost';
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return `blocked suffix ${suffix}`;
  }
  if (!h.includes('.')) return 'single-label hostname';
  return null;
}

/**
 * Static (no-DNS) SSRF check for a webhook URL. Returns { allowed:false,
 * reason } for anything that must never be fetched. DNS resolution and the
 * resolved-IP check happen in assertWebhookTargetAllowed().
 */
export function checkWebhookUrlStatic(rawUrl: string): SsrfCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `scheme ${url.protocol} not allowed (http/https only)` };
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'userinfo in URL is not allowed' };
  }
  const blockedHost = isBlockedHostname(url.hostname);
  if (blockedHost) return { allowed: false, reason: `blocked hostname: ${blockedHost}` };
  if (isBlockedIpLiteral(url.hostname)) {
    return { allowed: false, reason: `blocked IP literal: ${url.hostname}` };
  }
  return { allowed: true };
}
