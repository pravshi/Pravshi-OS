/**
 * SSRF guard — DNS answers and connection pinning.
 *
 * No external network: DNS is mocked, and the pinned connection targets a
 * loopback server this suite starts. The pinning cases run Node's real HTTP
 * stack, so they prove the connection goes to the validated address — the
 * hostname is a reserved .invalid name (RFC 6761) that can never resolve, so
 * a request that reaches the server cannot have re-resolved it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/jobs/handler-registry', () => ({
  registerHandler: vi.fn(),
}));

const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

import { assertWebhookTargetAllowed, fetchWebhookPinned } from '../../apps/worker/src/handlers';

const answers = (...ips: string[]) =>
  ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

beforeEach(() => {
  dnsLookup.mockReset();
});

describe('assertWebhookTargetAllowed — every DNS answer is checked', () => {
  it('pins the first answer when every answer is public', async () => {
    dnsLookup.mockResolvedValue(answers('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'));
    const target = await assertWebhookTargetAllowed('https://hooks.example.com/x');
    expect(target).toMatchObject({ pinnedIp: '93.184.216.34', pinnedFamily: 4 });
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(dnsLookup).toHaveBeenCalledWith('hooks.example.com', { all: true });
  });

  it('pins an IPv6 first answer with family 6', async () => {
    dnsLookup.mockResolvedValue(answers('2606:4700:4700::1111'));
    const target = await assertWebhookTargetAllowed('https://v6.example.com/x');
    expect(target).toMatchObject({ pinnedIp: '2606:4700:4700::1111', pinnedFamily: 6 });
  });

  it.each([
    [['93.184.216.34', '10.0.0.5'], 'a private answer after a public one'],
    [['10.0.0.5', '93.184.216.34'], 'a private answer first'],
    [['127.0.0.1'], 'loopback'],
    [['169.254.169.254'], 'cloud metadata'],
    [['64:ff9b::a9fe:a9fe'], 'NAT64 to the metadata address'],
    [['::ffff:10.0.0.1'], 'IPv4-mapped private'],
    [['198.18.0.1'], 'benchmarking range'],
    [['240.0.0.1'], 'reserved range'],
    [['fd00::1'], 'unique-local'],
    [['ff02::1'], 'multicast'],
  ])('refuses %j (%s) — one bad answer refuses the target', async (ips) => {
    dnsLookup.mockResolvedValue(answers(...ips));
    await expect(assertWebhookTargetAllowed('https://rebind.example.com/x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses an empty answer', async () => {
    dnsLookup.mockResolvedValue([]);
    await expect(assertWebhookTargetAllowed('https://empty.example.com/x')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('a DNS failure is a retryable error and pins nothing', async () => {
    dnsLookup.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    await expect(assertWebhookTargetAllowed('https://gone.example.com/x')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
    dnsLookup.mockRejectedValueOnce(new Error('no code'));
    await expect(assertWebhookTargetAllowed('https://gone.example.com/x')).rejects.toMatchObject({
      code: 'EAI_AGAIN',
    });
  });

  it('blocks statically before any DNS query', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      // Refused by the single-label rule before any range check (every
      // IPv6-literal URL is); NAT64 range coverage is the DNS-answer case above.
      'http://[64:ff9b::7f00:1]/hook',
      'http://admin.localhost/hook',
      'http://224.0.0.1/hook',
    ]) {
      await expect(assertWebhookTargetAllowed(url), url).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});

describe('fetchWebhookPinned — the connection goes to the validated address only', () => {
  let server: Server;
  let port: number;
  const seen: Array<{ host?: string; method?: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, body });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const send = (pinnedIp: string, timeoutMs = 5000) =>
    fetchWebhookPinned(new URL(`http://pinned.example.invalid:${port}/hook`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"a":1}'),
      timeoutMs,
      pinnedIp,
      pinnedFamily: 4,
    });

  // Reaching the server at all is the proof: the .invalid name cannot resolve,
  // so the connection can only have gone to the pinned address. (Node's own
  // connect does not use the mocked node:dns/promises, so the mock's call
  // count says nothing here.)
  it('connects to the pinned IP and keeps the Host header', async () => {
    seen.length = 0;
    const result = await send('127.0.0.1');
    expect(result.status).toBe(200);
    expect(seen).toEqual([
      { host: `pinned.example.invalid:${port}`, method: 'POST', body: '{"a":1}' },
    ]);
  });

  it('opens a fresh connection per request: a pooled socket never replaces the pin', async () => {
    seen.length = 0;
    await send('127.0.0.1');
    expect(seen).toHaveLength(1);
    // Same host and port, pinned elsewhere (127.0.0.2: loopback, nothing
    // listening). A keep-alive pool keyed by host:port would reuse the first
    // socket and reach the server again without ever asking the pin.
    await expect(send('127.0.0.2', 2000)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
